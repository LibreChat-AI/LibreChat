const axios = require('axios');

async function CropController(req, res) {
  try {
    const response = await axios.get(
      `${process.env.VITE_AJRASAKHA_SERVER_URL}/crops/get-all-crops-client`,
      {
        headers: {
          'x-internal-api-key': process.env.WEB_WEBHOOK_API_KEY,
        },
      },
    );

    return res.status(200).json(response.data);
  } catch (error) {
    console.error('Error fetching crops:', error.message);

    if (error.response) {
      // The external API responded with an error status
      return res.status(error.response.status).json({
        message: 'Error from crops API',
        details: error.response.data,
      });
    }

    return res.status(500).json({
      message: 'Failed to fetch crops',
      error: error.message,
    });
  }
}

module.exports = CropController;
