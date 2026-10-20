import { NextRequest } from 'next/server';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Data Center maintenance jobs. The backend has no remote maintenance API, so
 * these report honestly as unsupported rather than faking progress/completion.
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  return Response.json({
    success: false,
    id,
    message: `"${id}" maintenance is not exposed by the backend — no changes made`,
  });
}
