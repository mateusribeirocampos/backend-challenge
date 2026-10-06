/** The time source. The domain never reads the clock by itself; tests and adapters pass it in. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');
