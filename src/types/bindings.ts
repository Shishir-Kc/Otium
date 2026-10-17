export type OtiumBindings = CloudflareBindings & {
  /** Comma-separated exact frontend origins allowed to make credentialed browser requests. */
  FRONTEND_ORIGINS?: string;
  /** One-time secret used to bootstrap the first administrator account. Configure as a Wrangler secret. */
  BOOTSTRAP_ADMIN_CODE?: string;
};
