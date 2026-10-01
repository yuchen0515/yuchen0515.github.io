#!/usr/bin/env python3
"""Independently verify every commit proposed for public website publication."""
import argparse
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
PUBLISHED_BASE = '248457d659c1524f841223856f8cf3ece4c2ca58'

def verify(repo, revision):
    def git(*args):
        return subprocess.check_output(['git','-C',str(repo),*args],stderr=subprocess.PIPE)
    spec=importlib.util.spec_from_file_location('publication_policy',repo/'tools/publication_policy.py')
    policy=importlib.util.module_from_spec(spec);spec.loader.exec_module(policy)
    sha=git('rev-parse','--verify',revision+'^{commit}').decode().strip()
    if subprocess.run(['git','-C',str(repo),'merge-base','--is-ancestor',PUBLISHED_BASE,sha],capture_output=True).returncode:
        return {'approved':False,'reason':'revision is outside the preserved public ancestry','revision':sha,'violations':[]}
    violations=[];blob_cache={};count=0
    release=set(git('rev-list',PUBLISHED_BASE+'..'+sha).decode().splitlines())
    for row in git('rev-list','--parents',sha).decode().splitlines():
        values=row.split();commit=values[0];count+=1
        legacy=commit not in release
        if not legacy and len(values)!=2:violations.append({'commit':commit,'reason':'unexpected source parent shape'})
        for item in git('ls-tree','-rz','--full-tree',commit).split(b'\0'):
            if not item:continue
            info,name=item.split(b'\t',1);mode,kind,blob=info.decode().split();name=name.decode()
            reason=policy.internal_path_reason(name) if legacy else policy.classify_path(name,mode)
            if reason:violations.append({'commit':commit,'path':name,'reason':reason});continue
            if kind=='blob' and policy.public_document(name):
                if blob not in blob_cache:blob_cache[blob]=git('cat-file','blob',blob)
                for reason in policy.document_disclosures(name,blob_cache[blob]):violations.append({'commit':commit,'path':name,'reason':reason})
        if not legacy:
            metadata=json.loads(subprocess.check_output(['node',str(repo/'lib/public-assets.cjs'),'--git-tree-publication',commit],cwd=repo,stderr=subprocess.PIPE))
            for name in metadata['private_posts']:violations.append({'commit':commit,'path':name,'reason':'unpublished article source'})
            allowed=set(metadata['uploads'])
            for name in git('ls-tree','-rz','--name-only',commit).decode().split('\0'):
                if name.startswith('source/images/uploads/') and name not in allowed:violations.append({'commit':commit,'path':name,'reason':'unpublished upload'})
    return {'approved':not violations,'policy_version':policy.POLICY_VERSION,'revision':sha,'checked_commits':count,'violations':violations}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo',type=Path,default=Path.cwd())
    parser.add_argument('--revision',required=True)
    parser.add_argument('--remote-ref')
    parser.add_argument('--report',type=Path)
    args=parser.parse_args()
    if args.remote_ref and args.remote_ref!='refs/heads/source':
        print('Publication check rejected: only the reviewed public source branch may be pushed.');return 1
    try:result=verify(args.repo.resolve(),args.revision)
    except Exception:
        print('Publication check could not complete; no push is approved.');return 1
    if args.report:
        args.report.parent.mkdir(parents=True,exist_ok=True);args.report.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    if not result['approved']:
        print('Publication check rejected: public files or history need review.');return 1
    print(f"Publication check passed ({result['checked_commits']} commit trees).");return 0

if __name__=='__main__':raise SystemExit(main())
