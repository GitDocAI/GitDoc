/** What publish.ts and the asset migrator need from a destination. */
export interface ObjectSink {
  getWrittenKeys(): Set<string>
  putJson(key: string, value: unknown): Promise<void>
  putHtml(key: string, html: string): Promise<void>
  putText(key: string, text: string, contentType?: string): Promise<void>
  putBytes(key: string, bytes: ArrayBuffer, contentType: string): Promise<void>
  patchDomainIndex(
    puts: Array<{ hostname: string; orgId: string; docId: string; isPrivate: boolean }>,
    removes: string[],
  ): Promise<void>
  listObjects(prefix: string): Promise<string[]>
  deleteObjects(keys: string[]): Promise<void>
}

export interface MappingSink {
  putMapping(mapping: import('../types').DomainMapping): Promise<void>
}
