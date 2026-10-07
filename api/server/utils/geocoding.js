// const geocoding = async ({ villageName, blockName, district, state }) => {
//   const key = process.env.GOOGLE_MAPS_API_KEY;
//   if (!key) return null;

//   // Most specific first, then fall back to coarser areas
//   const attempts = [
//     [villageName, blockName, district, state],
//     [blockName, district, state],
//     [district, state],
//     [state],
//   ]
//     .map((parts) => parts.filter(Boolean))
//     .filter((parts) => parts.length > 0);

//   for (const parts of attempts) {
//     const params = new URLSearchParams({
//       address: [...parts, 'India'].join(', '),
//       components: 'country:IN',
//       key,
//     });
//     const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
//     const data = await res.json();

//     if (data.status === 'OK' && data.results?.[0]) {
//       const { lat, lng } = data.results[0].geometry.location;
//       return { latitude: lat, longitude: lng };
//     }
//     // ZERO_RESULTS -> try a coarser address; anything else (quota, denied) -> stop
//     if (data.status !== 'ZERO_RESULTS') {
//       console.warn(`Geocoding failed: ${data.status} ${data.error_message ?? ''}`);
//       break;
//     }
//   }
//   return null;
// };

// module.exports = { geocoding };
