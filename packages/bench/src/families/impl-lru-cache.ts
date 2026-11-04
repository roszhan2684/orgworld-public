import type { TaskFamily } from '../types.ts';
import { header, pick, tc } from './_util.ts';

/**
 * implementation / difficulty 2: an LRU cache whose recency policy differs per variant
 * (classic, write-only recency, read-only recency with in-place updates), plus capacity-0, eviction callback,
 * stored-undefined and SameValueZero key semantics.
 */
const POLICIES = [
  {
    name: 'classic',
    getRefresh: true,
    setRefresh: true,
    rule: 'Recency policy: a get(key) that finds the key makes it the most recently used; set(key, value) makes key the most recently used whether it is new or already present.',
  },
  {
    name: 'write-recency',
    getRefresh: false,
    setRefresh: true,
    rule: 'Recency policy (write-recency): ONLY set() affects recency. set(key, value) makes key the most recently used whether it is new or already present; get(key) NEVER changes the order.',
  },
  {
    name: 'read-recency',
    getRefresh: true,
    setRefresh: false,
    rule: 'Recency policy: a get(key) that finds the key makes it the most recently used. set(key, value) for a NEW key inserts it as the most recently used, but set() on a key that is ALREADY present only replaces its value and does NOT change its position.',
  },
] as const;

function reference(v: number): string {
  const p = pick(POLICIES, v);
  return `class LRUCache {
  constructor(capacity, onEvict) {
    if (!Number.isInteger(capacity) || capacity < 0) throw new RangeError('capacity must be a non-negative integer');
    this._capacity = capacity;
    this._onEvict = onEvict;
    this._map = new Map();
  }
  get size() {
    return this._map.size;
  }
  has(key) {
    return this._map.has(key);
  }
  get(key) {
    if (!this._map.has(key)) return undefined;
    const value = this._map.get(key);
${p.getRefresh ? '    this._map.delete(key);\n    this._map.set(key, value);\n' : ''}    return value;
  }
  set(key, value) {
    if (this._map.has(key)) {
${p.setRefresh ? '      this._map.delete(key);\n' : ''}      this._map.set(key, value);
      return this;
    }
    if (this._capacity === 0) return this;
    if (this._map.size >= this._capacity) {
      const oldest = this._map.keys().next().value;
      const oldValue = this._map.get(oldest);
      this._map.delete(oldest);
      if (this._onEvict) this._onEvict(oldest, oldValue);
    }
    this._map.set(key, value);
    return this;
  }
  delete(key) {
    return this._map.delete(key);
  }
  keys() {
    return [...this._map.keys()];
  }
}
module.exports = { LRUCache };
`;
}

export const implLruCache: TaskFamily = {
  id: 'impl-lru-cache',
  category: 'implementation',
  difficulty: 2,
  variants: POLICIES.length,
  referenceDeliverable: reference,
  generate(v) {
    const idx = ((v % POLICIES.length) + POLICIES.length) % POLICIES.length;
    const p = POLICIES[idx]!;
    const by = <T>(a: T, b: T, c: T): string => JSON.stringify([a, b, c][idx]);
    const h = header(['LRUCache']) + 'const spy = () => { const calls = []; const fn = (k, v) => calls.push([k, v]); fn.calls = calls; return fn; };\n';
    const basic = tc(
      'evicts the least recently used entry when full',
      `const c = new LRUCache(2);
c.set('a', 1); c.set('b', 2); c.set('c', 3);
assert.deepStrictEqual(c.keys(), ['b', 'c']);
assert.strictEqual(c.has('a'), false);
assert.strictEqual(c.get('a'), undefined);
assert.strictEqual(c.size, 2);`,
    );
    const getRecency = tc(
      'whether get() refreshes recency',
      `const c = new LRUCache(2);
c.set('a', 1); c.set('b', 2);
assert.strictEqual(c.get('a'), 1);
c.set('c', 3);
assert.deepStrictEqual(c.keys(), ${by(['a', 'c'], ['b', 'c'], ['a', 'c'])});`,
    );
    const hidden = [
      basic,
      getRecency,
      tc(
        'whether updating an existing key refreshes recency',
        `const c = new LRUCache(2);
c.set('a', 1); c.set('b', 2); c.set('a', 10); c.set('c', 3);
assert.deepStrictEqual(c.keys(), ${by(['a', 'c'], ['a', 'c'], ['b', 'c'])});
assert.strictEqual(c.get('a'), ${by(10, 10, undefined)});`,
      ),
      tc(
        'has() never affects recency',
        `const c = new LRUCache(2);
c.set('a', 1); c.set('b', 2);
assert.strictEqual(c.has('a'), true);
c.set('c', 3);
assert.deepStrictEqual(c.keys(), ['b', 'c']);`,
      ),
      tc(
        'capacity must be a non-negative integer',
        `for (const bad of [-1, 1.5, '2', NaN, undefined, Infinity]) assert.throws(() => new LRUCache(bad), RangeError, String(bad));
assert.doesNotThrow(() => new LRUCache(0));`,
      ),
      tc(
        'capacity 0 stores nothing and evicts nothing',
        `const ev = spy();
const c = new LRUCache(0, ev);
assert.strictEqual(c.set('a', 1), c);
assert.strictEqual(c.size, 0);
assert.strictEqual(c.has('a'), false);
assert.strictEqual(c.get('a'), undefined);
assert.deepStrictEqual(c.keys(), []);
assert.deepStrictEqual(ev.calls, []);`,
      ),
      tc(
        'set returns the cache for chaining',
        `const c = new LRUCache(3);
assert.strictEqual(c.set('x', 1), c);
c.set('y', 2).set('z', 3);
assert.deepStrictEqual(c.keys(), ['x', 'y', 'z']);`,
      ),
      tc(
        'delete frees capacity and does not call onEvict',
        `const ev = spy();
const c = new LRUCache(2, ev);
c.set('a', 1); c.set('b', 2);
assert.strictEqual(c.delete('a'), true);
assert.strictEqual(c.delete('a'), false);
c.set('c', 3);
assert.deepStrictEqual(c.keys(), ['b', 'c']);
assert.strictEqual(c.size, 2);
assert.deepStrictEqual(ev.calls, []);`,
      ),
      tc(
        'onEvict receives (key, value) once per capacity eviction only',
        `const ev = spy();
const c = new LRUCache(1, ev);
c.set('x', 1); c.set('x', 2);
assert.deepStrictEqual(ev.calls, []);
c.set('y', 3);
assert.deepStrictEqual(ev.calls, [['x', 2]]);
c.delete('y');
assert.deepStrictEqual(ev.calls, [['x', 2]]);`,
      ),
      tc(
        'a stored undefined value is still present',
        `const c = new LRUCache(2);
c.set('u', undefined);
assert.strictEqual(c.has('u'), true);
assert.strictEqual(c.size, 1);
assert.deepStrictEqual(c.keys(), ['u']);
assert.strictEqual(c.get('u'), undefined);`,
      ),
      tc(
        'keys use SameValueZero (Map) semantics',
        `const c = new LRUCache(3);
c.set(1, 'num'); c.set('1', 'str'); c.set(NaN, 'nan');
assert.strictEqual(c.size, 3);
assert.strictEqual(c.get(1), 'num');
assert.strictEqual(c.get('1'), 'str');
assert.strictEqual(c.get(NaN), 'nan');`,
      ),
      tc(
        'get on a missing key returns undefined and inserts nothing',
        `const c = new LRUCache(2);
assert.strictEqual(c.get('zz'), undefined);
assert.strictEqual(c.size, 0);
assert.strictEqual(c.has('zz'), false);`,
      ),
      tc(
        'longer mixed sequence',
        `const ev = spy();
const c = new LRUCache(3, ev);
c.set('a', 1); c.set('b', 2); c.set('c', 3);
assert.strictEqual(c.get('a'), 1);
c.set('d', 4);
c.set('b', 20);
assert.strictEqual(c.get('c'), ${by(undefined, 3, undefined)});
c.set('e', 5);
assert.deepStrictEqual(c.keys(), ['d', 'b', 'e']);
assert.deepStrictEqual(ev.calls, ${by([['b', 2], ['c', 3], ['a', 1]], [['a', 1], ['c', 3]], [['b', 2], ['c', 3], ['a', 1]])});`,
      ),
      tc(
        'update then insert into a full cache',
        `const ev = spy();
const c = new LRUCache(3, ev);
c.set('a', 1); c.set('b', 2); c.set('c', 3); c.set('a', 9); c.set('d', 4);
assert.deepStrictEqual(c.keys(), ${by(['c', 'a', 'd'], ['c', 'a', 'd'], ['b', 'c', 'd'])});
assert.deepStrictEqual(ev.calls, ${by([['b', 2]], [['b', 2]], [['a', 9]])});`,
      ),
    ];
    return {
      id: `impl-lru-cache#${v}`,
      family: 'impl-lru-cache',
      category: 'implementation',
      variant: v,
      difficulty: 2,
      title: `LRU cache (${p.name} recency)`,
      statement: [
        'Implement a CommonJS module exporting { LRUCache }, a class with this interface:',
        '- new LRUCache(capacity, onEvict?) — capacity must be a non-negative integer (a number for which Number.isInteger is true and >= 0), otherwise throw a RangeError. onEvict is an optional function.',
        '- get(key) → the stored value, or undefined if the key is absent.',
        '- set(key, value) → returns the cache itself (for chaining). Inserting a NEW key when the cache already holds `capacity` entries first evicts the least recently used entry and then, if onEvict was given, calls onEvict(evictedKey, evictedValue) exactly once. With capacity 0, set() stores nothing and never calls onEvict.',
        '- has(key) → boolean; never affects recency.',
        '- delete(key) → true if the key was present and removed, else false; never calls onEvict.',
        '- size → a getter property (not a method) with the number of stored entries.',
        '- keys() → a new array of the stored keys ordered from least recently used to most recently used.',
        p.rule,
        'onEvict is only called for capacity evictions (never for delete() or for overwriting a value). Keys may be of any type and are compared like Map keys (SameValueZero: NaN equals NaN, 1 and "1" differ). A stored value may be undefined; has() still reports such a key as present.',
      ].join('\n'),
      deliverable: 'solution',
      starterCode:
        'class LRUCache {\n  constructor(capacity, onEvict) {\n    // TODO\n  }\n  get size() {\n    // TODO\n  }\n  get(key) {}\n  set(key, value) {}\n  has(key) {}\n  delete(key) {}\n  keys() {}\n}\nmodule.exports = { LRUCache };\n',
      publicChecks: h + basic + getRecency,
      hiddenChecks: h + hidden.join(''),
    };
  },
};
