import type { TaskFamily } from '../types.ts';
import { header, mutate, pick, tc } from './_util.ts';

/**
 * debugging / difficulty 2: a small event emitter with interacting bugs around once(), off() and iteration
 * while the listener list is being mutated. Variants differ in API details (boolean vs count return value,
 * wildcard listeners) and in which bugs are present.
 */
const COMMON_SPEC = [
  '- on(event, fn): registers fn at the end of the listener list for event and returns the emitter. Registering the same function twice registers it twice. Throws a TypeError if fn is not a function.',
  '- once(event, fn): like on(), but the registration is removed right before its first invocation (so it runs at most once, even if it emits the same event again). Throws a TypeError if fn is not a function.',
  '- off(event, fn): removes ONE registration of fn for event — the most recently added one — whether it was registered with on() or once() (pass the original function). Does nothing if there is none. Returns the emitter.',
  '- listenerCount(event): the number of registrations currently held for event (once-registrations included).',
  '- Listeners are called synchronously in registration order with the emit arguments, with `this` set to the emitter.',
  '- emit() works on a SNAPSHOT of the listener list taken when emit starts: listeners added during an emit are not called until the next emit, and listeners removed during an emit (by off() or because they were once-listeners) are still called in that emit if they were in the snapshot.',
];

interface Variant {
  name: string;
  spec: string[];
  reference: string;
  starter: string;
}

const HEAD = `class Emitter {
  constructor() {
    this._listeners = new Map();
  }
  _list(event) {
    let list = this._listeners.get(event);
    if (!list) {
      list = [];
      this._listeners.set(event, list);
    }
    return list;
  }
`;
const CHECK = "    if (typeof fn !== 'function') throw new TypeError('listener must be a function');\n";
const ENTRY_METHODS = `  on(event, fn) {
${CHECK}    this._list(event).push({ fn, once: false });
    return this;
  }
  once(event, fn) {
${CHECK}    this._list(event).push({ fn, once: true });
    return this;
  }
  off(event, fn) {
    const list = this._listeners.get(event);
    if (!list) return this;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].fn === fn) {
        list.splice(i, 1);
        break;
      }
    }
    return this;
  }
  listenerCount(event) {
    const list = this._listeners.get(event);
    return list ? list.length : 0;
  }
`;
const TAIL = '}\nmodule.exports = { Emitter };\n';

/** Starter style shared by v0/v2: once() implemented with a wrapper that off(original) cannot find. */
const WRAPPER_METHODS = `  on(event, fn) {
${CHECK}    this._list(event).push(fn);
    return this;
  }
  once(event, fn) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      return fn.apply(this, args);
    };
    return this.on(event, wrapper);
  }
  off(event, fn) {
    const list = this._listeners.get(event);
    if (!list) return this;
    const i = list.lastIndexOf(fn);
    if (i !== -1) list.splice(i, 1);
    return this;
  }
  listenerCount(event) {
    const list = this._listeners.get(event);
    return list ? list.length : 0;
  }
`;

const VARIANTS: Variant[] = [
  {
    name: 'boolean emit',
    spec: ['- emit(event, ...args): calls the listeners and returns true if the event had at least one listener, otherwise false.'],
    reference: `${HEAD}${ENTRY_METHODS}  emit(event, ...args) {
    const list = this._listeners.get(event);
    if (!list || list.length === 0) return false;
    for (const entry of list.slice()) {
      if (entry.once) {
        const i = list.indexOf(entry);
        if (i !== -1) list.splice(i, 1);
      }
      entry.fn.apply(this, args);
    }
    return true;
  }
${TAIL}`,
    starter: `${HEAD}${WRAPPER_METHODS}  emit(event, ...args) {
    const list = this._listeners.get(event);
    if (!list || list.length === 0) return false;
    for (let i = 0; i < list.length; i++) {
      list[i].apply(this, args);
    }
    return true;
  }
${TAIL}`,
  },
  {
    name: 'counting emit',
    spec: ['- emit(event, ...args): calls the listeners and returns the NUMBER of listener invocations it made (0 if the event had no listeners).'],
    reference: `${HEAD}${ENTRY_METHODS}  emit(event, ...args) {
    const list = this._listeners.get(event);
    if (!list || list.length === 0) return 0;
    const snapshot = list.slice();
    for (const entry of snapshot) {
      if (entry.once) {
        const i = list.indexOf(entry);
        if (i !== -1) list.splice(i, 1);
      }
      entry.fn.apply(this, args);
    }
    return snapshot.length;
  }
${TAIL}`,
    starter: `${HEAD}${mutate(ENTRY_METHODS, [
      `    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].fn === fn) {
        list.splice(i, 1);
        break;
      }
    }`,
      `    const i = list.findIndex((entry) => entry.fn === fn);
    if (i !== -1) list.splice(i, 1);`,
    ])}  emit(event, ...args) {
    const list = this._listeners.get(event);
    if (!list) return 0;
    for (const entry of list.slice()) {
      if (entry.once) list.splice(list.indexOf(entry), 1);
      entry.fn.apply(this, args);
    }
    return list.length;
  }
${TAIL}`,
  },
  {
    name: 'wildcard listeners',
    spec: [
      "- Wildcards: listeners registered for the special event name '*' are called on every emit(event, ...args) with event !== '*', AFTER the event's own listeners, and receive (event, ...args). once('*', fn) and off('*', fn) work as for any other event. Both snapshots (the event's own list and the '*' list) are taken when emit starts. emit('*') is never called directly.",
      '- emit(event, ...args): returns true if at least one listener (own or wildcard) was invoked, otherwise false.',
    ],
    reference: `${HEAD}${ENTRY_METHODS}  emit(event, ...args) {
    const own = this._listeners.get(event) || [];
    const wild = event === '*' ? [] : this._listeners.get('*') || [];
    const jobs = [];
    for (const entry of own) jobs.push([own, entry, false]);
    for (const entry of wild) jobs.push([wild, entry, true]);
    for (const [list, entry, withEvent] of jobs) {
      if (entry.once) {
        const i = list.indexOf(entry);
        if (i !== -1) list.splice(i, 1);
      }
      if (withEvent) entry.fn.call(this, event, ...args);
      else entry.fn.apply(this, args);
    }
    return jobs.length > 0;
  }
${TAIL}`,
    starter: `${HEAD}${WRAPPER_METHODS}  emit(event, ...args) {
    const own = this._list(event);
    const wild = event === '*' ? [] : this._list('*');
    for (const fn of own.slice()) fn.apply(this, args);
    for (const fn of wild.slice()) fn.call(this, event, ...args);
    return own.length + wild.length > 0;
  }
${TAIL}`,
  },
];

export const debugEventEmitter: TaskFamily = {
  id: 'debug-event-emitter',
  category: 'debugging',
  difficulty: 2,
  variants: VARIANTS.length,
  referenceDeliverable: (v) => pick(VARIANTS, v).reference,
  generate(v) {
    const idx = ((v % VARIANTS.length) + VARIANTS.length) % VARIANTS.length;
    const p = VARIANTS[idx]!;
    const T = idx === 1 ? (n: number) => String(n) : (n: number) => String(n > 0);
    const h = header(['Emitter']) + 'const recorder = () => { const log = []; const mk = (name) => function (...args) { log.push(name + ":" + args.join(",")); }; return { log, mk }; };\n';
    const order = tc(
      'calls listeners in registration order with the arguments',
      `const e = new Emitter();
const { log, mk } = recorder();
e.on('x', mk('a')).on('x', mk('b'));
assert.strictEqual(e.emit('x', 1, 2), ${T(2)});
assert.deepStrictEqual(log, ['a:1,2', 'b:1,2']);`,
    );
    const onceSkip = tc(
      'a once-listener removing itself does not skip the next listener',
      `const e = new Emitter();
const { log, mk } = recorder();
e.once('x', mk('a'));
e.on('x', mk('b'));
assert.strictEqual(e.emit('x'), ${T(2)});
assert.deepStrictEqual(log, ['a:', 'b:']);
assert.strictEqual(e.emit('x'), ${T(1)});
assert.deepStrictEqual(log, ['a:', 'b:', 'b:']);`,
    );
    const offOnce = tc(
      'off() with the original function removes a once-registration',
      `const e = new Emitter();
let calls = 0;
const f = () => { calls++; };
e.once('x', f);
assert.strictEqual(e.listenerCount('x'), 1);
e.off('x', f);
assert.strictEqual(e.listenerCount('x'), 0);
assert.strictEqual(e.emit('x'), ${T(0)});
assert.strictEqual(calls, 0);`,
    );
    const hidden = [
      order,
      onceSkip,
      offOnce,
      tc('emit without listeners', `const e = new Emitter();\nassert.strictEqual(e.emit('nothing'), ${T(0)});`),
      tc(
        'this is the emitter',
        `const e = new Emitter();
let seen = null;
e.on('x', function () { seen = this; });
e.emit('x');
assert.strictEqual(seen, e);`,
      ),
      tc(
        'once fires a single time',
        `const e = new Emitter();
let calls = 0;
e.once('x', () => { calls++; });
e.emit('x'); e.emit('x');
assert.strictEqual(calls, 1);
assert.strictEqual(e.listenerCount('x'), 0);`,
      ),
      tc(
        'listeners added during emit wait for the next emit',
        `const e = new Emitter();
const { log, mk } = recorder();
let added = false;
e.on('x', () => { log.push('a'); if (!added) { added = true; e.on('x', mk('late')); } });
assert.strictEqual(e.emit('x', 1), ${T(1)});
assert.deepStrictEqual(log, ['a']);
e.emit('x', 2);
assert.deepStrictEqual(log, ['a', 'a', 'late:2']);`,
      ),
      tc(
        'listeners removed during emit still run in that emit',
        `const e = new Emitter();
const { log, mk } = recorder();
const b = mk('b');
e.on('x', () => { log.push('a'); e.off('x', b); });
e.on('x', b);
assert.strictEqual(e.emit('x'), ${T(2)});
assert.deepStrictEqual(log, ['a', 'b:']);
e.emit('x');
assert.deepStrictEqual(log, ['a', 'b:', 'a']);`,
      ),
      tc(
        'same function registered twice runs twice; off removes one registration',
        `const e = new Emitter();
let calls = 0;
const f = () => { calls++; };
e.on('x', f).on('x', f);
e.emit('x');
assert.strictEqual(calls, 2);
assert.strictEqual(e.off('x', f), e);
e.emit('x');
assert.strictEqual(calls, 3);`,
      ),
      tc(
        'off removes the most recently added registration',
        `const e = new Emitter();
const { log, mk } = recorder();
const f = mk('f');
e.on('x', f);
e.on('x', mk('g'));
e.on('x', f);
e.off('x', f);
e.emit('x');
assert.deepStrictEqual(log, ['f:', 'g:']);`,
      ),
      tc(
        'off picks the newer once-registration over an older on-registration',
        `const e = new Emitter();
let calls = 0;
const f = () => { calls++; };
e.on('x', f);
e.once('x', f);
e.off('x', f);
e.emit('x'); e.emit('x');
assert.strictEqual(calls, 2);`,
      ),
      tc(
        'off of an unknown listener is a chainable no-op',
        `const e = new Emitter();
const f = () => {};
assert.strictEqual(e.off('nope', f), e);
e.on('x', () => {});
assert.strictEqual(e.off('x', f), e);
assert.strictEqual(e.listenerCount('x'), 1);`,
      ),
      tc(
        'on/once reject non-functions',
        `const e = new Emitter();
assert.throws(() => e.on('x', 42), TypeError);
assert.throws(() => e.once('x', null), TypeError);
assert.strictEqual(e.listenerCount('x'), 0);`,
      ),
      tc(
        'a once-listener that re-emits is not called recursively',
        `const e = new Emitter();
let calls = 0;
e.once('x', () => { calls++; e.emit('x'); });
e.emit('x');
assert.strictEqual(calls, 1);`,
      ),
      tc(
        'removing a pending once-listener during emit leaves the others intact',
        `const e = new Emitter();
const { log, mk } = recorder();
const b = mk('b');
e.on('x', () => { log.push('a'); e.off('x', b); });
e.once('x', b);
e.on('x', mk('c'));
assert.strictEqual(e.emit('x'), ${T(3)});
assert.deepStrictEqual(log, ['a', 'b:', 'c:']);
assert.strictEqual(e.listenerCount('x'), 2);
e.emit('x');
assert.deepStrictEqual(log, ['a', 'b:', 'c:', 'a', 'c:']);`,
      ),
    ];
    if (idx === 2) {
      hidden.push(
        tc(
          'wildcard listeners run after own listeners and receive the event name',
          `const e = new Emitter();
const { log, mk } = recorder();
e.on('*', mk('w'));
e.on('x', mk('a'));
assert.strictEqual(e.emit('x', 7), true);
assert.strictEqual(e.emit('y', 8), true);
assert.deepStrictEqual(log, ['a:7', 'w:x,7', 'w:y,8']);`,
        ),
        tc(
          'once wildcard fires once and can be removed with the original function',
          `const e = new Emitter();
let calls = 0;
const w = () => { calls++; };
e.once('*', w);
assert.strictEqual(e.emit('a'), true);
assert.strictEqual(e.emit('b'), false);
assert.strictEqual(calls, 1);
e.once('*', w);
e.off('*', w);
assert.strictEqual(e.listenerCount('*'), 0);
assert.strictEqual(e.emit('c'), false);
assert.strictEqual(calls, 1);`,
        ),
        tc(
          'emit reports true when only once-listeners ran',
          `const e = new Emitter();
e.once('x', () => {});
assert.strictEqual(e.emit('x'), true);
assert.strictEqual(e.emit('x'), false);`,
        ),
      );
    }
    return {
      id: `debug-event-emitter#${v}`,
      family: 'debug-event-emitter',
      category: 'debugging',
      variant: v,
      difficulty: 2,
      title: `Fix the event emitter (${p.name})`,
      statement: [
        'The CommonJS module in the starter code exports { Emitter }, a small synchronous event emitter class, but it has bugs. Fix it so that it behaves exactly as specified (keep the same export and method names):',
        ...COMMON_SPEC,
        ...p.spec,
      ].join('\n'),
      deliverable: 'solution',
      starterCode: p.starter,
      publicChecks: h + order + offOnce,
      hiddenChecks: h + hidden.join(''),
    };
  },
};
