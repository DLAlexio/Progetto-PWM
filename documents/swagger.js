import swaggerAutogen from 'swagger-autogen';

const doc = {
    info: {
      title: 'Fast Food API - Rimoldi Diego',
      description: 'Documentazione endpoint API REST, per il progetto "Fast Food" del corso di Programmazione Web e Mobile - A.A. 2025/2026'
    },
    host: 'localhost:3000'
  };

const outputFile = './documents/swagger.json';
const inputFiles = ['./index.js', './routes/users.js', './routes/meals.js', './routes/restaurants.js', './routes/orders.js', './routes/carts.js'];

swaggerAutogen(outputFile,inputFiles, doc);
