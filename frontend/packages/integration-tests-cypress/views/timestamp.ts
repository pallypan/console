export const timestamp = {
  isLoaded: () => cy.byTestID('timestamp').should('exist'),
};
