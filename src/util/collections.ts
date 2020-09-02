export function addToMapSet<K, V>(target: Map<K, Set<V>>, key : K, value : V) {
    if (!target.has(key))
        target.set(key, new Set());
    (target.get(key) as Set<V>).add(value);
}
