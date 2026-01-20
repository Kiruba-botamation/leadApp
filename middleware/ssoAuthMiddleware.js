const ssoAuthMiddleware = (req, res, next) => {
  try {
    // Check for SSO cookie or authorization header
    const ssoToken = req.cookies?.sso_token || req.headers?.authorization?.split(' ')[1];

    if (!ssoToken) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized: SSO token required'
      });
    }

    // In a real scenario, you would validate the SSO token here
    // For now, we'll just attach it to the request
    req.user = { token: ssoToken };
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized'
    });
  }
};

export default ssoAuthMiddleware;
