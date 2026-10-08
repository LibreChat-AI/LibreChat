export class MediaSourceAppender {
  private readonly mediaSource = new MediaSource();
  private readonly audioChunks: ArrayBuffer[] = [];
  private readonly type: string;

  private objectUrl?: string;
  private sourceBuffer?: SourceBuffer;
  private isClosed = false;

  constructor(type: string) {
    this.type = type;
    this.mediaSource.addEventListener('sourceopen', () => {
      if (this.sourceBuffer != null) {
        return;
      }

      this.sourceBuffer = this.mediaSource.addSourceBuffer(this.type);
      this.sourceBuffer.addEventListener('updateend', () => {
        this.tryAppendNextChunk();
      });

      /** `sourceopen` only fires once a media element attaches the object URL, which
       *  can land after the whole response was already read. Draining here is what
       *  keeps short (fast) responses from stranding their chunks in the queue. */
      this.tryAppendNextChunk();
    });
  }

  private tryAppendNextChunk() {
    if (this.sourceBuffer == null || this.sourceBuffer.updating) {
      return;
    }

    const chunk = this.audioChunks.shift();
    if (chunk == null) {
      this.tryEndOfStream();
      return;
    }

    this.sourceBuffer.appendBuffer(chunk);
  }

  private tryEndOfStream() {
    /** `endOfStream()` only throws while the source is not open or a buffer is updating —
     *  an empty response still has to end, or the element waits on it forever. */
    if (!this.isClosed || this.mediaSource.readyState !== 'open') {
      return;
    }
    if (this.audioChunks.length > 0 || this.sourceBuffer?.updating === true) {
      return;
    }

    this.mediaSource.endOfStream();
  }

  public addBase64Data(base64Data: string) {
    this.addData(
      Uint8Array.from(atob(base64Data), (char) => char.charCodeAt(0)).buffer as ArrayBuffer,
    );
  }

  public addData(data: ArrayBuffer) {
    this.audioChunks.push(data);
    this.tryAppendNextChunk();
  }

  /**
   * Signals that no further data will arrive. The media source is only ended once every
   * queued chunk has been appended, so the tail of the audio is never truncated.
   */
  public close() {
    this.isClosed = true;
    this.tryEndOfStream();
  }

  public get mediaSourceUrl() {
    this.objectUrl ??= URL.createObjectURL(this.mediaSource);
    return this.objectUrl;
  }
}
