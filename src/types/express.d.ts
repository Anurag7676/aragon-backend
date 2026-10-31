declare global {
  namespace Express {
    interface Request {
      /** Set by the authenticate middleware. */
      user?: { id: string };
    }
  }
}

export {};
