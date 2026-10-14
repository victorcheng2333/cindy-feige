/** Only non-secret file metadata and an owner/sender-bound selection ID cross IPC. */
export interface VertexServiceAccountSelection {
  selectionId: string;
  fileName: string;
  project: string;
}
export interface VertexServiceAccountSave {
  selectionId: string;
  project: string;
  location: string;
}
