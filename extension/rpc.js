// UI timeouts only stop waiting; Chrome may still finish an outstanding operation.
const READ_REQUESTS = new Set(["status", "regionStatus", "protectionStatus", "cleanupStatus"]);

export function withTimeout(promise, timeoutMs, message = "读取浏览器状态超时，请重新检查。") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message); error.code = "RPC_TIMEOUT"; reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function sendRequest(api, message, { timeoutMs } = {}) {
  const readOnly = READ_REQUESTS.has(message.type);
  const limit = timeoutMs ?? (readOnly ? 4000 : 10000);
  for (let attempt = 0; attempt < (readOnly ? 2 : 1); attempt++) {
    let answer;
    try {
      answer = await withTimeout(Promise.resolve().then(() => api.runtime.sendMessage(message)), limit,
        readOnly ? "读取后台状态超时，请重新检查。" : "等待后台操作超时；结果未确认，请重新检查状态后再操作。");
    } catch (error) {
      if (readOnly && attempt === 0) continue;
      if (!readOnly && error.code !== "RPC_TIMEOUT") {
        throw new Error(`操作结果未确认：${error.message}。请重新检查状态后再操作。`);
      }
      throw error;
    }
    // A returned rejection is a backend decision, not a transport retry signal.
    if (!answer?.ok) throw new Error(answer?.error || "后台没有返回有效状态，请重新检查。");
    return answer.data;
  }
}
