import { lookup } from 'node:dns/promises';

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Resolves a host name to every address. Injected in tests; never called for IP literals. */
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family === 6 ? 6 : 4,
  }));
};
