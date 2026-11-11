import { useHostMutations, useHosts } from "@/runtime/host-runtime";
import { getSshKeyImport } from "@/hosts/ssh/ssh-transport";
import {
  RemoteSshHostForm,
  type AddRemoteSshHostModalProps,
} from "@/components/remote-ssh-host-form";
export type { AddRemoteSshHostModalProps } from "@/components/remote-ssh-host-form";

/** Bind SSH setup to the saved-host registry and this platform's key import. */
export function AddRemoteSshHostModal(props: AddRemoteSshHostModalProps) {
  const hosts = useHosts();
  const { probeAndUpsertRemoteSshConnection } = useHostMutations();
  return (
    <RemoteSshHostForm
      {...props}
      hosts={hosts}
      probeAndUpsertRemoteSshConnection={probeAndUpsertRemoteSshConnection}
      keyImport={getSshKeyImport()}
    />
  );
}
