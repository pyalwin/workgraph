export type JobHandler = (params: unknown) => Promise<unknown>;

export const noopHandler: JobHandler = async (params) => ({
  echo: params,
  ran_at: new Date().toISOString(),
});
