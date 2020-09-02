export async function asyncFilter<T>(arr: T[], cb: (t: T) => Promise<boolean>): Promise<T[]> {
  const filterBits = await Promise.all(arr.map(t => cb(t)));
  return arr.filter(_ => filterBits.shift());
}
