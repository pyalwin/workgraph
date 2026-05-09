import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import {
  ProjectKeyExistsError,
  createProject,
} from '@/lib/project-crud';
import { PROJECT_KEY_PATTERN } from '@/lib/project-connectors';

export const dynamic = 'force-dynamic';

interface CreateBody {
  key?: unknown;
  name?: unknown;
}

export async function POST(req: NextRequest) {
  const { user } = await withAuth();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const rawKey = typeof body.key === 'string' ? body.key.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!rawKey) {
    return NextResponse.json({ error: 'key is required' }, { status: 400 });
  }
  const key = rawKey.toUpperCase();
  if (!PROJECT_KEY_PATTERN.test(key)) {
    return NextResponse.json(
      { error: 'invalid_key', pattern: PROJECT_KEY_PATTERN.source },
      { status: 400 },
    );
  }

  try {
    const project = await createProject({
      key,
      name: name || key,
      createdVia: 'manual',
    });
    return NextResponse.json({ ok: true, project }, { status: 201 });
  } catch (err) {
    if (err instanceof ProjectKeyExistsError) {
      return NextResponse.json(
        { error: 'project_key_exists', existingProjectKey: err.key },
        { status: 409 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
