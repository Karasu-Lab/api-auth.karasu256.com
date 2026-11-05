export class UploadVerificationError extends Error {
  constructor() {
    super('api.karasu256.com failed to verify the upload');
    this.name = 'UploadVerificationError';
  }
}
