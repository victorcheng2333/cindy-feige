#!/usr/bin/env python3
"""Prepare a one-time personal JPush import outside the checkout; never echo secrets."""
import argparse
import getpass
import json
import os
import re
import secrets
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-key', required=True, help='Public JPush AppKey')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-f0-9]{24}', args.app_key):
        parser.error('AppKey must be 24 lowercase hexadecimal characters')
    secret = getpass.getpass('JPush Master Secret（不回显）: ').strip()
    if not re.fullmatch(r'[A-Za-z0-9]{16,128}', secret):
        parser.error('Master Secret format is invalid')
    filename = os.path.join(tempfile.gettempdir(), 'cindy-jpush-import-' + secrets.token_hex(16) + '.json')
    descriptor = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        json.dump({'appKey': args.app_key, 'masterSecret': secret, 'deleteAfterImport': True}, output)
    print('退出并以此参数重新打开新版 Cindy；配置只绑定届时登录的账号：')
    print('--jpush-config=' + filename)
    print('导入成功后此临时文件自动删除。未使用时请删除该文件。')


if __name__ == '__main__':
    main()
