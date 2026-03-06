export function isDebugEnabled(): boolean {
  return process.env.PI_LCM_DEBUG === '1';
}

export function debugLog(message: string, data?: unknown): void {
  if (!isDebugEnabled()) return;
  if (data === undefined) {
    console.log(`pi-lcm: debug: ${message}`);
    return;
  }
  console.log(`pi-lcm: debug: ${message}`, data);
}
