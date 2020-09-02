export async function applySeries<T>(array: T[], f: (q: T) => void) {
    for(const elem of array) {
        await f(elem);
    }
}

export async function mapSeries<T, R>(array: T[], f: (q: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    for(const elem of array) {
        results.push(await f(elem));
    }
    return results;
}

export async function filterSeries<T>(array: T[], f: (q: T) => Promise<boolean>): Promise<T[]> {
    const results: T[] = [];
    for(const elem of array) {
        if (await f(elem))
            results.push(elem);
    }
    return results;
}
