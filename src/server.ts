/**
 * VPS Panel - Main Server Entry Point
 *
 * Bootstraps the application via createApp(), starts the HTTP server,
 * registers signal handlers for graceful shutdown.
 *
 * The full module wiring and initialization logic lives in ./app.ts.
 *
 * Requirements: 8.4, 8.5, 8.6
 */
import 'dotenv/config';
import { createApp, isDockerSocketReachable, isProcAvailable, isPtyAvailable } from './app.js';
import type { EnvConfig } from './config/env.js';

// Re-export for backward compatibility with tests and external usage
export { createApp, isDockerSocketReachable, isProcAvailable, isPtyAvailable } from './app.js';
export { validateEnv, validateEnvSafe, getConfigSummary } from './config/env.js';

// --- Legacy bootstrap wrapper (for backward compat with existing tests) ---

/**
 * Bootstrap the application.
 * @deprecated Use `createApp` directly for better type safety.
 */
export function bootstrap(envConfig?: EnvConfig): any {
  const instance = createApp(envConfig);
  return {
    app: instance.app,
    io: instance.io,
    httpServer: instance.httpServer,
    config: instance.config,
    db: instance.db,
    startBackgroundServices: instance.startBackgroundServices,
    shutdown: instance.shutdown,
  };
}

export type BootstrapReturnType = ReturnType<typeof bootstrap>;

// --- Auto-start when run directly ---

const isDirectRun =
  process.argv[1]?.replace(/\\/g, '/').includes('server') ?? false;

if (isDirectRun && !process.env.VITEST) {
  const instance = createApp();

  // Initialize PostgreSQL and run migrations before starting
  instance.initializePostgres()
    .then(() => {
      // Start background services
      instance.startBackgroundServices();

      // Listen
      instance.httpServer.listen(instance.config.PORT, () => {
        console.log(
          `[VPS Panel] Server listening on port ${instance.config.PORT} (${instance.config.ENVIRONMENT})`
        );
        console.log(`[VPS Panel] Docker host: ${instance.config.DOCKER_HOST}`);
        console.log(`[VPS Panel] Degradation status:`, instance.degradation);
      });
    })
    .catch((error) => {
      console.error('[VPS Panel] Failed to initialize PostgreSQL:', error);
      process.exit(1);
    });

  // Graceful shutdown on signals
  process.on('SIGTERM', () => {
    instance.shutdown();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    instance.shutdown();
    process.exit(0);
  });
}
