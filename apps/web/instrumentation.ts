export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startSourceSync } = await import("./server/sources");
    startSourceSync();
  }
}
