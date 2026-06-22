import { NextResponse } from 'next/server';

const CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vQB5zksIeRf-3KpVEzkz7SBx6LrhJELjVqy7q4s6_OhCSGWnMIqK2WlBrJeGaoj2KIGPFwBHO3FwotQ/pub?gid=1927135130&single=true&output=csv';

export async function GET() {
  try {
    const res = await fetch(CSV_URL, { cache: 'no-store' });
    const text = await res.text();
    return new NextResponse(text, {
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return new NextResponse('Error fetching sheet', { status: 500 });
  }
}