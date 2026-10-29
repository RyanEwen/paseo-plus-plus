/** Native notifications are delivered by remote push, without a renderer image. */
export async function getNotificationProjectIcon(
  _data: Record<string, unknown> | undefined,
): Promise<string | undefined> {
  return undefined;
}
