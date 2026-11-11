import type { DispatchableClass } from '../lib/dispatch';
import { CreateApiKeyDispatch, DeleteApiKeyDispatch, GetApiKeyDispatch, IssueApiKeyDispatch, ListApiKeysDispatch, ListPermissionsDispatch, UpdateApiKeyPermissionsDispatch, VerifyApiKeyDispatch } from './api-keys';
import { AuthDispatch } from './auth';
import { ClientRegistrationDispatch } from './client-registration';
import { GithubAppInstallUrlDispatch, GithubAppTokenDispatch, GithubRepositoriesDispatch, GithubUserDispatch } from './github';
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
import {
  InstallationTokenDispatch,
  InstallationWebhookDispatch,
  LinkPackageDispatch,
  ListUserTenantsDispatch,
  PushWebhookDispatch,
  SetLinkedPackageEnabledDispatch,
  UnlinkPackageDispatch,
  TenantInstallationDispatch,
  TenantOverviewDispatch,
  UninstallBotDispatch,
  UpdateLinkedPackagePointerDispatch,
} from './tenants';
import { CreateTestAccountDispatch, DeleteTestAccountDispatch } from './test-accounts';

export const dispatchables: DispatchableClass[] = [
  SetPasswordDispatch,
  ClientRegistrationDispatch,
  AuthDispatch,
  VerifyApiKeyDispatch,
  ListApiKeysDispatch,
  GetApiKeyDispatch,
  UpdateApiKeyPermissionsDispatch,
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
  GithubAppInstallUrlDispatch,
  GithubAppTokenDispatch,
  ListUserTenantsDispatch,
  TenantOverviewDispatch,
  TenantInstallationDispatch,
  UninstallBotDispatch,
  InstallationTokenDispatch,
  LinkPackageDispatch,
  SetLinkedPackageEnabledDispatch,
  UnlinkPackageDispatch,
  UpdateLinkedPackagePointerDispatch,
  PushWebhookDispatch,
  InstallationWebhookDispatch,
  SignInLookupDispatch,
  CreateTestAccountDispatch,
  DeleteTestAccountDispatch,
];
