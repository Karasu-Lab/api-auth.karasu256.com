import { describe, expect, it } from 'vitest';
import { generateSshKeyPair } from '../src/lib/signing-key';

function readSshString(buffer: Buffer, offset: number): { value: Buffer; next: number } {
  const length = buffer.readUInt32BE(offset);
  return { value: buffer.subarray(offset + 4, offset + 4 + length), next: offset + 4 + length };
}

describe('generateSshKeyPair', () => {
  it('produces an OpenSSH ed25519 pair whose public key matches the private key', async () => {
    const pair = await generateSshKeyPair();

    expect(pair.publicKey.startsWith('ssh-ed25519 ')).toBe(true);
    expect(pair.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true);
    expect(pair.privateKey.trimEnd().endsWith('-----END OPENSSH PRIVATE KEY-----')).toBe(true);
    expect(pair.fingerprint.startsWith('SHA256:')).toBe(true);

    const blob = Buffer.from(pair.publicKey.split(' ')[1]!, 'base64');
    const algorithm = readSshString(blob, 0);
    expect(algorithm.value.toString()).toBe('ssh-ed25519');
    const rawPublicKey = readSshString(blob, algorithm.next).value;
    expect(rawPublicKey.length).toBe(32);

    const pemBody = pair.privateKey
      .replace('-----BEGIN OPENSSH PRIVATE KEY-----', '')
      .replace('-----END OPENSSH PRIVATE KEY-----', '')
      .replace(/\s+/g, '');
    const body = Buffer.from(pemBody, 'base64');
    expect(body.subarray(0, 15).toString()).toBe('openssh-key-v1\0');
    let offset = 15;
    const cipher = readSshString(body, offset);
    offset = cipher.next;
    const kdf = readSshString(body, offset);
    offset = kdf.next;
    expect(cipher.value.toString()).toBe('none');
    expect(kdf.value.toString()).toBe('none');
    const kdfOptions = readSshString(body, offset);
    offset = kdfOptions.next;
    expect(body.readUInt32BE(offset)).toBe(1);
    offset += 4;
    const embeddedPublic = readSshString(body, offset);
    offset = embeddedPublic.next;
    expect(embeddedPublic.value.equals(blob)).toBe(true);
    const privateBlock = readSshString(body, offset).value;
    expect(privateBlock.readUInt32BE(0)).toBe(privateBlock.readUInt32BE(4));
    let privateOffset = 8;
    const privateAlgorithm = readSshString(privateBlock, privateOffset);
    privateOffset = privateAlgorithm.next;
    expect(privateAlgorithm.value.toString()).toBe('ssh-ed25519');
    const embeddedRawPublic = readSshString(privateBlock, privateOffset);
    privateOffset = embeddedRawPublic.next;
    expect(embeddedRawPublic.value.equals(rawPublicKey)).toBe(true);
    const privateMaterial = readSshString(privateBlock, privateOffset);
    expect(privateMaterial.value.length).toBe(64);
    expect(privateMaterial.value.subarray(32).equals(rawPublicKey)).toBe(true);
  });
});
