import { config } from "./config.js";
import { validHash } from "./auth.js";
import { createApp } from "./app.js";
if (
  process.env.NODE_ENV === "production" &&
  (!validHash(config.passwordHash) ||
    config.workerToken.length < 32 ||
    !config.secureCookies ||
    config.allowedOrigins.some((origin) => !origin.startsWith("https://")))
) {
  throw new Error(
    "Production requires a password hash, internal token, COOKIE_SECURE=true and HTTPS APP_ORIGINS. See README.md.",
  );
}
const app = await createApp(config);
const listener = app.listen(config.port, config.host, () =>
  console.log(`boykov-services API: http://${config.host}:${config.port}`),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    listener.close(() => {
      app.locals.technical?.stop();
      app.locals.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 8000).unref();
  });
