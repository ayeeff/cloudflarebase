import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const ROUTE_MAP: Record<string, string> = {
	maps: '/dashboard/geo-site/content/maps',
	categories: '/dashboard/geo-site/content/categories',
	articles: '/dashboard/geo-site/content/articles',
	blog: '/dashboard/geo-site/content/blog',
	write: '/dashboard/geo-site/content/write',
	search_index: '/dashboard/geo-site/content/search',
	templates: '/dashboard/geo-site/content/templates',
	update: '/dashboard/geo-site/content/update'
};

export const GET: RequestHandler = ({ params }) => {
	const sub = params.path?.split('/')[0] ?? '';
	const target = ROUTE_MAP[sub] ?? '/dashboard/geo-site/content/maps';
	throw redirect(308, target);
};
