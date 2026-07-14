import type { ExtensionUiRequest } from './types';

const permissionRequestTitle = 'Pi 请求权限';

export function isPermissionRequest(
  request: ExtensionUiRequest | null | undefined,
): boolean {
  return Boolean(
    request?.method === 'select' &&
      String(request.title || '').trimStart().startsWith(permissionRequestTitle),
  );
}

export function permissionRequestDetails(request: ExtensionUiRequest): {
  action: string;
  detail: string;
} {
  const title = String(request.title || '').replace(/\r\n/g, '\n');
  const body = title.slice(title.indexOf(permissionRequestTitle) + permissionRequestTitle.length).trim();
  const lines = body.split('\n');
  const summary = lines.shift()?.trim() || '';
  const separator = summary.indexOf(' · ');

  if (separator >= 0) {
    return {
      action: summary.slice(0, separator).trim() || '执行受保护操作',
      detail: [summary.slice(separator + 3), ...lines].join('\n').trim(),
    };
  }

  return {
    action: summary || '执行受保护操作',
    detail: lines.join('\n').trim() || String(request.message || '').trim(),
  };
}
