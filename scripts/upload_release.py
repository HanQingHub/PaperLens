"""PaperLens GitHub Release 上传脚本（tauri-plugin-updater 配套）。

原位置 Temp\\opencode\\upload_release.py 已收编至此；如需修改请改本文件。
用法：
  $env:GITHUB_TOKEN = 'ghp_xxx'
  python scripts/upload_release.py --tag v0.3.0
  python scripts/upload_release.py --tag v0.3.0 --repo owner/PaperLens --release-dir dist/release
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

TOKEN = os.environ.get('GITHUB_TOKEN', '')


def parse_args():
    ap = argparse.ArgumentParser(description='上传 PaperLens release 资产（更新包 + .sig + latest.json）')
    ap.add_argument('--tag', required=True, help='release tag，如 v0.3.0')
    ap.add_argument('--repo', default='HanQingHub/PaperLens')
    ap.add_argument('--release-dir', default='dist/release', help='产物目录（相对仓库根）')
    ap.add_argument('--proxy', default='http://127.0.0.1:7897')
    ap.add_argument('--notes', default='', help='release body（新建 release 时使用）')
    return ap.parse_args()


def api(url, token, proxy, data=None, method=None, headers=None, binary=None):
    h = {'Authorization': f'Bearer {token}', 'User-Agent': 'paperlens-release'}
    if headers:
        h.update(headers)
    body = None
    if binary is not None:
        body = binary
    elif data is not None:
        body = json.dumps(data).encode()
        h['Content-Type'] = 'application/json'
    req = urllib.request.Request(
        url,
        data=body,
        method=method or ('POST' if data is not None or binary is not None else 'GET'),
        headers=h,
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({'http': proxy, 'https': proxy}))
    try:
        with opener.open(req, timeout=180) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main():
    args = parse_args()
    if not TOKEN:
        print('缺少环境变量 GITHUB_TOKEN'); sys.exit(1)
    tag = args.tag
    ver = tag.lstrip('v')
    if not re.fullmatch(r'v?\d+\.\d+\.\d+', tag):
        print(f'tag 格式非法：{tag}，应为 v?\\d+.\\d+.\\d+'); sys.exit(1)

    release_dir = args.release_dir
    if not os.path.isabs(release_dir):
        release_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), release_dir)

    base = f'https://api.github.com/repos/{args.repo}'
    status, body = api(f'{base}/releases/tags/{tag}', TOKEN, args.proxy)
    if status == 200:
        rel = json.loads(body)
        print('release exists:', rel['id'])
    else:
        status, body = api(f'{base}/releases', TOKEN, args.proxy, {
            'tag_name': tag, 'name': f'PaperLens v{ver}',
            'body': args.notes, 'draft': False, 'prerelease': False,
        })
        if status not in (200, 201):
            print('release create failed:', status, body[:300]); sys.exit(1)
        rel = json.loads(body)
        print('release created:', rel['id'])

    upload_url = rel['upload_url'].split('{')[0]
    assets = [
        (f'PaperLens_{ver}_x64-setup-update.exe', 'application/octet-stream'),
        (f'PaperLens_{ver}_x64-setup-update.exe.sig', 'text/plain'),
        ('latest.json', 'application/json'),
    ]
    for fname, ctype in assets:
        path = os.path.join(release_dir, fname)
        with open(path, 'rb') as f:
            data = f.read()
        url = f'{upload_url}?name={urllib.parse.quote(fname)}'
        status, body = api(url, TOKEN, args.proxy, binary=data, method='POST', headers={'Content-Type': ctype})
        ok = status in (200, 201)
        print(f'{fname}: {status} {"OK" if ok else body[:200]}')
        if not ok:
            sys.exit(1)
    print('ALL DONE')


if __name__ == '__main__':
    main()