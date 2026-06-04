<p><img src="https://github.com/user-attachments/assets/da5bb809-3949-4854-99e4-1619022444e7" width="128"/></p>

# Ryelite
Ryelite is an open-source game client for High Spell. Currently pending official permission to operate from the game developer (Dew). Highlite, which this client is forked from, has received said permission.

---

## Game Hooks

Hooks are how plugins reach into the live game and grab useful stuff — nearest player, world entities, bank UI, whatever — **without** caring that the original class names got mangled to things like `aD`, `xk`, `RV` when the client was bundled.

When the game is built / minified it **loses the readable names**. So instead of hard‑coding random letters every update, we give each important class a *stable, human nickname* and teach the reflector how to spot the real (obfuscated) class each build.

---

## The Core Idea

> “Give a stable, human name to an obfuscated class.”

You write a little **signature** describing how to recognize the class.
The reflector scans the client, finds the matching obfuscated class name, remembers the pairing, and exposes it at:

```ts
document.highlite.gameHooks.<YourName>
```

So your plugin never touches `aD` directly; it just uses `WorldEntityManager`.

---

## What is a Signature?

A tiny object that says “the class I want has *these* method names, field names, or has a unique token inside.”

```ts
interface ClassSignature {

  // Method or getter names (static or instance)
  methods?: string[];

  // Field / property names
  fields?: string[];           

  // Some text inside the class body
  contains?: string;
}
```

| Part       | Use it when                                                                | Example                         |
| ---------- | -------------------------------------------------------------------------- | ------------------------------- |
| `methods`  | The class has distinctive method / accessor names                          | `['WorldEntities', 'Instance']` |
| `fields`   | There are unique backing fields you can see                                | `['_worldEntities']`            |
| `contains` | You need extra disambiguation (duplicate method names in multiple classes) | `'_alwaysHideRoofs'`            |

### Examples

**Simple:**

```ts
['GroundItemManager', { methods: ['GroundItemCount'] }]
```

**A case with an internal field to disambiguate:**

```ts
['WorldEntityManager', {
  methods: ['WorldEntities', 'Instance'],
  contains: '_alwaysHideRoofs'
}]
```

---

## How to find a hook

1. **Locate the class** you care about in the minified bundle (search for a distinctive getter / method).
2. **Draft a minimal signature** (start with *one* method).
3. Run:

   ```ts
   const test = Reflector.findClassBySignature({ methods: ['WorldEntities'] });
   console.log(test?.name);
   ```
4. If:

   * **No match** → remove a constraint or double‑check spelling.
   * **Wrong / ambiguous** → add another method OR add `contains: '_someInternalField'`.
5. Once it consistently returns the same obfuscated name (e.g. `aD`), **add it to** `reflection/signatures.ts` in the Core repo.

---

## Example: WorldEntityManager

Minified snippet:

```js
class aD {
  static get Instance() {
    return this._worldEntityManager || (this._worldEntityManager = new aD),
           this._worldEntityManager
  }
  get WorldEntities() { return this._worldEntities }
  get AlwaysHideRoofs() { return this._alwaysHideRoofs }
  // ...
}
```

We’ll hook this as `WorldEntityManager`.

**Signature we choose:**

```ts
['WorldEntityManager', {
  methods: ['WorldEntities', 'Instance'],
  contains: '_alwaysHideRoofs'
}]
```

Add that tuple to `ClassSignatures` array in `reflection/signatures.ts`

So, now, on startup the signature will automatically find and bind the hook to the game hooks.

In your plugin, you can simply call the game hook. 

For example the following to access 

```ts
// Get our hook
const WorldEntityManager = document.highlite.gameHooks.WorldEntityManager;

// Call a static getter on the hook
const instance = WorldEntityManager.Instance;

// Live entities
const entities = instance.WorldEntities;
console.log('Entity count:', entities.length);
```

It's as simple as that!

---

## Choosing Good Signature Bits

* **Start small.** One solid method often enough.
* **Add `contains` only if** some other class also has those methods.
* **Avoid over‑listing** every method: more surface = more chance of breakage.

