import type { DispatchableClass } from '../lib/dispatch';
import { CreateApiKeyDispatch, DeleteApiKeyDispatch, GetApiKeyDispatch, IssueApiKeyDispatch, ListApiKeysDispatch, ListPermissionsDispatch, UpdateApiKeyPermissionsDispatch, VerifyApiKeyDispatch } from './api-keys';
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
import {
  CreateSigningKeyDispatch,
  RenameSigningKeyDispatch,
  RotateSigningKeyDispatch,
  SetSigningKeyEnabledDispatch,
  SigningKeyStatusDispatch,
} from './signing-keys';
import { SigningKeyMaterialDispatch } from './signing-key-material';
import {
  CreateBotPullRequestDispatch,
  CreateTenantRepositoryDispatch,
  InstallationTokenDispatch,
  LinkPackageDispatch,
  ListUserTenantsDispatch,
  PushWebhookDispatch,
  RecordNpmConfigurationDispatch,
  SetLinkedPackageEnabledDispatch,
  TenantInstallationDispatch,
  TenantOverviewDispatch,
  TenantRepositoriesDispatch,
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
  CreateSigningKeyDispatch,
  SigningKeyStatusDispatch,
  SigningKeyMaterialDispatch,
  RotateSigningKeyDispatch,
  RenameSigningKeyDispatch,
  SetSigningKeyEnabledDispatch,
  ListUserTenantsDispatch,
  TenantOverviewDispatch,
  TenantInstallationDispatch,
  TenantRepositoriesDispatch,
  CreateTenantRepositoryDispatch,
  RecordNpmConfigurationDispatch,
  InstallationTokenDispatch,
  LinkPackageDispatch,
  SetLinkedPackageEnabledDispatch,
  UpdateLinkedPackagePointerDispatch,
  PushWebhookDispatch,
  CreateBotPullRequestDispatch,
  SignInLookupDispatch,
  CreateTestAccountDispatch,
  DeleteTestAccountDispatch,
];
