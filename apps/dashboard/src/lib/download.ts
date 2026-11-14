/** Saves a downloaded file (leads CSV, audit log) under its name through a temporary object URL. */
export function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  // Attached for Firefox, which ignores clicks on a detached link.
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
