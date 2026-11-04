// R2 を区ごとに分ける薄い包み。キーを必ず区の ID で始め、区をまたいで読み書きできないようにする。
// 束は env.ORIGINALS を直接使わず、WardBucket を使う。

export class WardBucket {
  constructor(
    private readonly bucket: R2Bucket,
    readonly wardId: string,
  ) {
    if (!wardId || /[/\\]/.test(wardId)) throw new Error("区の ID が不正です");
  }

  /** 区の中のキーを R2 のキーにする。.. と空の部分と先頭の / を拒む。 */
  key(path: string): string {
    const parts = path.split("/");
    if (parts.some((p) => p === "" || p === "." || p === "..")) {
      throw new Error("R2 のキーが不正です");
    }
    return `${this.wardId}/${path}`;
  }

  get(path: string, options?: R2GetOptions) {
    return this.bucket.get(this.key(path), options);
  }

  head(path: string) {
    return this.bucket.head(this.key(path));
  }

  put(
    path: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    options?: R2PutOptions,
  ) {
    return this.bucket.put(this.key(path), value, options);
  }

  delete(path: string) {
    return this.bucket.delete(this.key(path));
  }

  /** 区の中のキーを列挙する。返るキーは区の ID を除いた形。 */
  async list(prefix = "", options?: { limit?: number; cursor?: string }) {
    const result = await this.bucket.list({
      prefix: `${this.wardId}/${prefix}`,
      limit: options?.limit,
      cursor: options?.cursor,
    });
    const strip = this.wardId.length + 1;
    return {
      keys: result.objects.map((o) => ({ ...o, key: o.key.slice(strip) })),
      truncated: result.truncated,
      cursor: result.truncated ? result.cursor : undefined,
    };
  }
}
