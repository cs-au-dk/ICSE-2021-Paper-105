export function addMapToMapArray<K, V>(target : Map<K, V[]>, source: Map<K, V[]>) {
    source.forEach((value, key) => {
        if (!target.has(key)) {
            target.set(key, []);
        }
        value.forEach(v => (target.get(key) as V[]).push(v));
    })
}

export function addToMapSet<K, V>(target: Map<K, Set<V>>, key : K, value : V) {
    if (!target.has(key))
        target.set(key, new Set());
    (target.get(key) as Set<V>).add(value);
}

// note: inefficient
export function setUnion<T>(sets: Set<T>[]) {
    return sets.reduce((combined, list) => {
        return new Set([...combined, ...list]);
    }, new Set());
}
