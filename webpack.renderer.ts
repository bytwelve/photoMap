import type { Configuration } from 'webpack';
import { rules } from './webpack.rules';

export const rendererConfig: Configuration = {
  devtool: 'source-map',
  module: {
    rules: [
      ...rules,
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      },
      {
        test: /\.(png|jpe?g|webp|svg|woff2?)$/,
        type: 'asset/resource'
      }
    ]
  },
  resolve: { extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'] },
  target: 'web'
};
