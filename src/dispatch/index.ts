import type { DispatchableClass } from '../lib/dispatch';
import { CreateApiKeyDispatch, DeleteApiKeyDispatch, IssueApiKeyDispatch, ListApiKeysDispatch, ListPermissionsDispatch, VerifyApiKeyDispatch } from './api-keys';
import { AuthDispatch } from './auth';
import { ClientRegistrationDispatch } from './client-registration';
import { McpIconUploadUrlDispatch, McpSessionTokenDispatch } from './mcp';
import {
  CompleteOAuthClientIconDispatch,
  ListOAuthClientInfoDispatch,
  PrepareOAuthClientIconDispatch,
  UpsertOAuthClientInfoDispatch,
} from './oauth-client-info';
import { ListAuthSessionsDispatch, ListSessionDevicesSourceDispatch, RevokeAuthSessionDispatch } from './sessions';
import { SetPasswordDispatch } from './set-password';
import { SignInLookupDispatch } from './sign-in-lookup';
import { CreateTestAccountDispatch, DeleteTestAccountDispatch } from './test-accounts';

export const dispatchables: DispatchableClass[] = [
  SetPasswordDispatch,
  ClientRegistrationDispatch,
  AuthDispatch,
  VerifyApiKeyDispatch,
  ListApiKeysDispatch,
  CreateApiKeyDispatch,
  DeleteApiKeyDispatch,
  ListPermissionsDispatch,
  ListOAuthClientInfoDispatch,
  CompleteOAuthClientIconDispatch,
  PrepareOAuthClientIconDispatch,
  UpsertOAuthClientInfoDispatch,
  IssueApiKeyDispatch,
  McpSessionTokenDispatch,
  McpIconUploadUrlDispatch,
  ListAuthSessionsDispatch,
  ListSessionDevicesSourceDispatch,
  RevokeAuthSessionDispatch,
  SignInLookupDispatch,
  CreateTestAccountDispatch,
  DeleteTestAccountDispatch,
];
