import type { DispatchableClass } from '../lib/dispatch';
import { CreateApiKeyDispatch, DeleteApiKeyDispatch, IssueApiKeyDispatch, ListApiKeysDispatch, ListPermissionsDispatch, VerifyApiKeyDispatch } from './api-keys';
import { AuthDispatch } from './auth';
import { ClientRegistrationDispatch } from './client-registration';
import { GithubRepositoriesDispatch, GithubUserDispatch } from './github';
import { McpIconUploadUrlDispatch, McpSessionTokenDispatch } from './mcp';
import {
  CompleteOAuthClientIconDispatch,
  GetOAuthClientInfoDispatch,
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
  GetOAuthClientInfoDispatch,
  CompleteOAuthClientIconDispatch,
  PrepareOAuthClientIconDispatch,
  UpsertOAuthClientInfoDispatch,
  IssueApiKeyDispatch,
  McpSessionTokenDispatch,
  McpIconUploadUrlDispatch,
  ListAuthSessionsDispatch,
  ListSessionDevicesSourceDispatch,
  RevokeAuthSessionDispatch,
  GithubUserDispatch,
  GithubRepositoriesDispatch,
  SignInLookupDispatch,
  CreateTestAccountDispatch,
  DeleteTestAccountDispatch,
];
