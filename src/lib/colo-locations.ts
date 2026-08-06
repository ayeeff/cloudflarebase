/**
 * Approximate coordinates for Cloudflare colos (IATA codes), for placing a
 * reported colo EXACTLY on the vendored world outline instead of snapping to
 * a coarse region anchor. Curated to the colos Durable Objects commonly run
 * in; unknown codes fall back to the caller's coarser placement. City-level
 * precision is plenty at 480x240.
 */

const COLO_COORDS: Record<string, [lat: number, lon: number]> = {
	// North America
	ATL: [33.6, -84.4],
	BOS: [42.4, -71.0],
	DEN: [39.9, -104.7],
	DFW: [32.9, -97.0],
	EWR: [40.7, -74.2],
	IAD: [38.9, -77.5],
	IAH: [30.0, -95.3],
	LAX: [33.9, -118.4],
	MCI: [39.3, -94.7],
	MEX: [19.4, -99.1],
	MIA: [25.8, -80.3],
	ORD: [42.0, -87.9],
	PHX: [33.4, -112.0],
	QRO: [20.6, -100.4],
	SEA: [47.4, -122.3],
	SJC: [37.4, -121.9],
	YVR: [49.2, -123.2],
	YYZ: [43.7, -79.6],
	// South America
	BOG: [4.7, -74.1],
	EZE: [-34.8, -58.5],
	GIG: [-22.8, -43.2],
	GRU: [-23.4, -46.5],
	LIM: [-12.0, -77.1],
	SCL: [-33.4, -70.8],
	// Europe
	AMS: [52.3, 4.8],
	ARN: [59.7, 17.9],
	ATH: [37.9, 23.9],
	BRU: [50.9, 4.5],
	BUD: [47.4, 19.3],
	CDG: [49.0, 2.5],
	CPH: [55.6, 12.7],
	DUB: [53.4, -6.2],
	FRA: [50.0, 8.6],
	HEL: [60.3, 25.0],
	IST: [41.3, 28.7],
	LHR: [51.5, -0.5],
	LIS: [38.8, -9.1],
	MAD: [40.5, -3.6],
	MAN: [53.4, -2.3],
	MXP: [45.6, 8.7],
	OSL: [60.2, 11.1],
	PRG: [50.1, 14.3],
	VIE: [48.1, 16.6],
	WAW: [52.2, 20.9],
	ZRH: [47.5, 8.5],
	// Africa
	CAI: [30.1, 31.4],
	CMN: [33.4, -7.6],
	CPT: [-34.0, 18.6],
	JNB: [-26.1, 28.2],
	LOS: [6.6, 3.3],
	NBO: [-1.3, 36.9],
	// Middle East
	AMM: [31.7, 36.0],
	BAH: [26.3, 50.6],
	DOH: [25.3, 51.6],
	DXB: [25.3, 55.4],
	KWI: [29.2, 48.0],
	RUH: [24.9, 46.7],
	TLV: [32.0, 34.9],
	// Asia
	BKK: [13.7, 100.7],
	BLR: [13.2, 77.7],
	BOM: [19.1, 72.9],
	CCU: [22.7, 88.4],
	CGK: [-6.1, 106.7],
	DEL: [28.6, 77.1],
	HAN: [21.2, 105.8],
	HKG: [22.3, 113.9],
	HYD: [17.2, 78.4],
	ICN: [37.5, 126.4],
	KIX: [34.4, 135.2],
	KUL: [2.7, 101.7],
	MAA: [13.0, 80.2],
	MNL: [14.5, 121.0],
	NRT: [35.8, 140.4],
	SGN: [10.8, 106.7],
	SIN: [1.4, 103.9],
	TPE: [25.1, 121.2],
	// Oceania
	ADL: [-34.9, 138.5],
	AKL: [-37.0, 174.8],
	BNE: [-27.4, 153.1],
	MEL: [-37.7, 144.8],
	PER: [-31.9, 116.0],
	SYD: [-33.9, 151.2]
};

/**
 * Projects a colo onto the outline's frame (equirectangular, longitude
 * -180..180 across the width, latitude 75N..60S down the height - the
 * bounds `$lib/world-outline` documents). Null for colos not in the table.
 */
export function coloPoint(
	colo: string,
	width: number,
	height: number
): { x: number; y: number } | null {
	const coords = COLO_COORDS[colo];
	if (!coords) return null;
	const [lat, lon] = coords;
	return { x: ((lon + 180) / 360) * width, y: ((75 - lat) / 135) * height };
}
