export function workerClient({ workerUrl, workerToken }) {
  return async function call(route, options = {}) {
    if (!workerToken)
      throw Object.assign(
        new Error("Сервис документов не настроен. Выполните npm run setup."),
        { status: 503 },
      );
    let response;
    try {
      response = await fetch(new URL(route, workerUrl), {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${workerToken}` },
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw Object.assign(
        new Error("Сервис документов недоступен. Проверьте его запуск."),
        { status: 503 },
      );
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw Object.assign(
        new Error(
          typeof error.detail === "string"
            ? error.detail
            : "Не удалось обработать запрос документов.",
        ),
        { status: response.status },
      );
    }
    return response;
  };
}
