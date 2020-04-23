import { checkErrors } from '../../support';
import { timestamp } from '../../views/timestamp';

describe('Localization', () => {
  before(() => {
    cy.login();
  });

  afterEach(() => {
    checkErrors();
  });

  after(() => {
    cy.logout();
  });

  it('pseudolocalizes navigation', () => {
    cy.log('test navigation');
    cy.visit('/dashboards?pseudolocalization=true&lng=en');
    cy.byTestID('nav', /\[[^a-zA-Z]+\]/);
  });

  it('pseudolocalizes timestamps', () => {
    cy.log('test timestamps');
    cy.visit('/dashboards?pseudolocalization=true&lng=en');
    timestamp.isLoaded();
    cy.byTestID('timestamp', /\[[^a-zA-Z]+\]/);
  });
});
