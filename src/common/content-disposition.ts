/** `attachment; filename="plain.pdf"; filename*=UTF-8''percent%20encoded.pdf` — safe for every name. */
export const contentDisposition = (kind: 'inline' | 'attachment', name: string): string => {
  const plain = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${plain}"; filename*=UTF-8''${encoded}`;
};
