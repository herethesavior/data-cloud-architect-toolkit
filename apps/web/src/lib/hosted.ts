/** True only for the Worker-hosted build (`VITE_HOSTED=true npm run build`). */
export function isHosted(): boolean {
  return import.meta.env.VITE_HOSTED === 'true';
}
