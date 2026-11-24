// Publish only our database commit on top of the latest branch. Never overwrite
// another database update made while the importer was running.
export function pushArchiveWithRetry(repoDir, branch, originalBase, run, attempts = 3) {
  const options = { cwd: repoDir };
  const git = args => run('git', args, options).stdout.trim();
  const canChangeDatabaseContract = file => {
    if (/(?:^|\/)(?:test|tests|__tests__)\//i.test(file) || /(?:\.test|\.spec)\.[cm]?[jt]sx?$/i.test(file)) return false;
    return /\.(?:[cm]?[jt]sx?|py|sql)$/i.test(file)
      || /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|Dockerfile|Procfile|render\.ya?ml|\.node-version)$/i.test(file)
      || /(?:^|\/)(?:migrations?|schema)(?:\/|$)/i.test(file);
  };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    git(['fetch', '--no-tags', 'origin', branch]);
    const localHead = git(['rev-parse', 'HEAD']);
    const remoteHead = git(['rev-parse', 'FETCH_HEAD']);
    const common = git(['merge-base', localHead, remoteHead]);

    // The server may have accepted the push even if its response was lost.
    if (common === localHead) return { pushed: true, commit: localHead, reason: 'already_published' };
    const changes = git(['diff', '--name-only', '--no-renames', '-z', originalBase, remoteHead]).split('\0').filter(Boolean);
    if (changes.some(file => file.startsWith('data/vehicles_ai.db.gz'))) {
      throw new Error('Remote vehicle database changed during import; refusing to overwrite newer data. Preserve the generated archive and rerun from the latest database.');
    }
    const contractChanges = changes.filter(canChangeDatabaseContract);
    if (contractChanges.length) {
      throw new Error('Production code or database schema changed during import; refusing to publish an unverified database. Preserve the generated archive and rerun using the latest code. Changed paths: ' + contractChanges.join(', '));
    }
    if (common !== remoteHead) {
      try {
        git(['rebase', remoteHead]);
      } catch (error) {
        try { git(['rebase', '--abort']); } catch { /* No rebase in progress. */ }
        throw error;
      }
    }
    try {
      git(['push', 'origin', `HEAD:${branch}`]);
      return { pushed: true, commit: git(['rev-parse', 'HEAD']), reason: 'pushed' };
    } catch (error) {
      if (attempt === attempts || !/non-fast-forward|fetch first|\[rejected\]/i.test(String(error.message))) throw error;
      // A new branch change can race the fetch; check it again before retrying.
    }
  }
  throw new Error('Archive publication retry limit reached');
}
