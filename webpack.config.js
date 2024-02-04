const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');

module.exports = {
    entry: './src/HistoryDiffPageScript.js',
    output: {
        filename: '[name].bundle.js',
        path: path.resolve(__dirname, 'dist'),
        clean: true
    },
    plugins: [
        new webpack.optimize.LimitChunkCountPlugin({
            maxChunks: 1
        }),
        new HtmlWebpackPlugin({
            filename: 'historydiff.html',
            template: './src/historydiff.html',
            minify: process.env.NODE_ENV !== 'production' ? false : {
                // Options used by default by HtmlWebpackPlugin
                collapseWhitespace: true,
                keepClosingSlash: true,
                removeComments: true,
                removeRedundantAttributes: true,
                removeScriptTypeAttributes: true,
                removeStyleLinkTypeAttributes: true,
                useShortDoctype: true,
                // Additional option compared to the default: Minimize css.
                minifyCSS: true
            }
        }),
    ],
};
