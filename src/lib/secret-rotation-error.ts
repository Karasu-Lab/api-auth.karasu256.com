export class SecretRotationNotAllowedError extends Error {
  constructor() {
    super('secret rotation is only available for clients using client_secret authentication');
    this.name = 'SecretRotationNotAllowedError';
  }
}
