
import requests
from requests.auth import HTTPBasicAuth
import os
import json
import sys

prs_info = []

def load_prs():
  gituser = os.getenv('GIT_USER')
  gittoken = os.getenv('GIT_TOKEN')

  pr_url = 'https://api.github.com/repos/openshift/console/pulls'

  prs = []
  page = 1
  while True:
    query = {'page': page, 'per_page': 100}
    resp = requests.get(pr_url, params=query, auth=HTTPBasicAuth(gituser, gittoken))
    if len(resp.json()) == 0:
      break
    page = page + 1
    prs = prs + resp.json()

  print('prs in total: %s' % len(prs))

  for pr in prs:
    pr_info = {
      'number': pr['number'],
      'files': []
    }

    pr_commits_url = pr['commits_url']
    resp = requests.get(pr_commits_url, auth=HTTPBasicAuth(gituser, gittoken))
    pr_commits = resp.json()
    for commit in pr_commits:
      commit_url = commit['url']
      resp = requests.get(commit_url, auth=HTTPBasicAuth(gituser, gittoken))
      commits = resp.json()
      files = commits['files']
      for change_file in files:
        pr_info['files'].append(change_file['filename'])
    
    prs_info.append(pr_info)

  with open('pr_files.json', 'w') as f:
    json.dump(prs_info, f)
  print("loaded all pr infos to pr_files.json!!")



pr_file = sys.argv[1]
print(pr_file)

if pr_file != None:
  with open(pr_file, 'r') as f:
    prs_info = json.load(f)
else:
  load_prs()

while True:
  filename = input("input file name: ")
  for pr in prs_info:
    files = pr['files']
    for file_name in files:
      if file_name.find(filename) >= 0:
        print('https://github.com/openshift/console/pull/%s/files' % pr['number'])
