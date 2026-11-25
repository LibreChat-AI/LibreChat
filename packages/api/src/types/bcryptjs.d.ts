/** `bcryptjs` ships no types. Declared narrowly: the sync calls run in the hash worker, the async ones only when it cannot. */
declare module 'bcryptjs' {
  export function hashSync(plain: string, rounds: number): string;
  export function compareSync(plain: string, hash: string): boolean;
  export function hash(plain: string, rounds: number): Promise<string>;
  export function compare(plain: string, hash: string): Promise<boolean>;
}
