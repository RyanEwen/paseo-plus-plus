import { projectIconRadius } from "@/components/project-icon-view";
import { projectIconCache } from "@/projects/icon-cache";
import { createProjectViewKey } from "@/projects/workspace-structure";
import { hostSupportsFeature } from "@/runtime/host-features";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { deriveIdentityColorName, identityColor } from "@/styles/identity-colors";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";

const SIZE = 64;

/** Rasterize repository images in an image element, where SVG scripts and external resources
 * are disabled. OS notification APIs need a PNG even when the sidebar renders an SVG.
 */
async function drawProjectImage(context: CanvasRenderingContext2D, uri: string): Promise<void> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error("Project notification image could not be decoded")),
      { once: true },
    );
    image.src = uri;
  });
  context.clearRect(0, 0, SIZE, SIZE);
  context.drawImage(image, 0, 0, SIZE, SIZE);
}

/** Resolve the same effective project image (or identity initial) as the sidebar.
 * Only daemon-supplied bytes cross into image decoding; never fetch an icon URL.
 */
export async function getNotificationProjectIcon(
  data: Record<string, unknown> | undefined,
): Promise<string | undefined> {
  const serverId = data?.serverId;
  const workspaceId = data?.workspaceId;
  if (typeof serverId !== "string" || typeof workspaceId !== "string") return undefined;
  const session = useSessionStore.getState().sessions[serverId];
  const workspace = session?.workspaces.get(workspaceId);
  if (!workspace) return undefined;
  const project = session.projects.get(workspace.projectId);
  if (!project) return undefined;

  const projectViewKey = createProjectViewKey(
    project.projectKey
      ? { kind: "equivalence", projectKey: project.projectKey }
      : { kind: "placement", serverId, projectId: project.projectId },
  );
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  const name = project.projectCustomName ?? project.projectDisplayName;
  const initial = projectIconPlaceholderLabelFromDisplayName(name).charAt(0).toUpperCase();
  context.fillStyle = identityColor(deriveIdentityColorName(projectViewKey));
  context.beginPath();
  context.roundRect(0, 0, SIZE, SIZE, projectIconRadius(SIZE));
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = "32px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(initial, SIZE / 2, SIZE / 2);
  const placeholder = canvas.toDataURL("image/png");

  const client = getHostRuntimeStore().getClient(serverId);
  const query = projectIconCache.query(
    {
      serverId,
      projectId: project.projectId,
      projectViewKey,
      iconWorkingDir: project.projectRootPath,
      customIconRevision: project.projectCustomIconRevision,
      iconRevision: project.projectIconRevision,
    },
    hostSupportsFeature(session.serverInfo, "projectCustomIcon"),
    () => client,
    Boolean(client),
  );
  try {
    const icon = query.initialData !== undefined ? query.initialData : await query.queryFn();
    if (!icon) return placeholder;
    await drawProjectImage(context, `data:${icon.mimeType};base64,${icon.data}`);
    return canvas.toDataURL("image/png");
  } catch {
    // A disconnected host or invalid image uses the sidebar's identity placeholder.
    return placeholder;
  }
}
